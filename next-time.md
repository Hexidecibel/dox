# Next Time

Notes and thoughts for the next session. Claude reads this on startup.

---

## 2026-08-01/03 MEASUREMENT SESSION — extraction fixed + measured; taxonomy P1/P2 built

Big session. Three threads: **fix the model fleet**, **actually measure extraction**, **start the
taxonomy rework**. 13 commits, `3bc3338`..`c959d86`+. Read the two AJ briefs' outcomes in
[[project_idp_document_registry]] and [[project_medosweet_finance_vertical]].

### DEPLOYED TO PROD (worker only)
- **The router hostname fix.** `qwen-llm/model-router.yaml` pointed at `ajs-mac-mini`; Tailscale had
  renamed the box **`ajs-mac-mini-2`**. Router marked the Q8 primary dead and silently failed over to
  the 4090's **Q4** — for months. Prod extraction ran on the quant that LOST the bake-off while the
  Q8 Mac sat healthy and unreachable. Fixed + verified: router now serves `UD-Q8_K_XL`.
  **Restart is `sudo -n systemctl restart qwen-llm.service`** (bare `systemctl` fails on polkit;
  `sudo -n` DOES work on this box).
- **Multi-record collapse fix** (`c959d86`) — worker restarted, verified live on 2 real prod items:
  `d5253a4d` 1 collapsed record → **3**, `c46e1579` → **2**, no comma-crammed values.
  `bin/process-worker` IS what systemd runs, so restart == deploy for worker-only changes.

### COMMITTED BUT **NOT DEPLOYED** (Pages + 4 prod migrations)
Prod schema gap, verified 2026-08-03:
```
0076 document_categories  : present      0080 facet tables        : NOT APPLIED
0077 registry cols        : present      0081 classification_status: NOT APPLIED
                                         0082 text_model          : NOT APPLIED
                                         0083 rejection_reason    : NOT APPLIED
```
Apply with **`bin/migrate --only <file>`** (new surgical mode). **NEVER bulk-run the chain.**
NOTE prod has TWO tracking tables that disagree — `_migrations` tops out at **0075**, and
0076–0079 were stamped elsewhere. See [[project_migration_chain_fragility]].

Not deployed: taxonomy P1+P2 UI, inline review warnings, rejection dialog, `text_model` persistence.

### THE THREE CORRECTIONS THAT MATTER
1. **`COA_RECORDS_MODE=shadow` is a NO-OP.** The worker's only gate is `!== 'off'` — shadow and on
   are byte-identical, and the consumer wiring shipped long ago. **The long-standing "flip
   shadow→on" task in earlier notes would have changed NOTHING.** Deleted as a task.
2. **`bin/parity-coa`'s dry-run was stale** — it called the legacy page-GROUPING chunker (the v1
   collapse bug's own chunker) and never ran `mergeCoaRecords`. Every parity run was grading a code
   path production no longer takes. Fixed. Treat old parity output with suspicion.
3. **Multi-record collapse was the PROMPT**, not config: it asserted "there is only one product on
   this page" — true for Darigold page-bundles, false for tabular COAs. Rewritten to one record per
   distinct certified result.

### MEASUREMENT — we now have real numbers ([[project_extraction_accuracy_measured]])
**Corpus accuracy 90.6% (85.1–93.5%)**, all 132 rejected + 140 pre-capture + 94 pending graded.
Three read-only scripts: `bin/check-extraction-invariants`, `bin/measure-extraction-accuracy`,
`bin/grade-unmeasured-queue`. Two findings redirected the roadmap:
- **The metric was blind to the biggest defect** (multi-record collapse, 95/366) — now fixed.
- **37% of error sits inside APPROVED docs** — the human gate leaks worse than the automation.
  Inline invariant warnings built in response (built, not deployed).
Selection bias was only ~2.5pts. Fabrication is RAREST (27); role confusion dominates (584).

### OPEN / NEXT
- **P3 is next and it is the risky one.** `document_categories` cannot be dropped in isolation —
  0079's `documents_fts_source` VIEW reads it and every FTS trigger inserts through that view;
  SQLite resolves views lazily so `DROP TABLE` would NOT error, it would silently make every
  document write fail at runtime. **13-step removal checklist is in `plan.md`.**
- **APPROVE STILL DELETES THE R2 OBJECT.** We stopped it on reject only (0083 `file_retain_until`,
  90d tombstone, sweeper deliberately not built). This is why the 95 historically-collapsed docs
  CANNOT be re-extracted. Fix before the next extractor improvement.
- **Latent landmine:** VLM-primary mode never populates `coaRecordsCapture` — enabling it today
  would silently re-break every multi-record COA. VLM is `off` in prod.
- Deferred small wins: empty-extraction-over-nonempty-text should warn (3 items, confidence 0.25);
  the `[object Object]` destroyed-payload case is skipped rather than flagged loudly.
- Re-queue more pending items with the fixed prompt: `bin/reprocess-queue --item <id>` (new) or
  `--tenant` (79 pending in `1f03c3e73add44bfafb33bb16508b78b`, hours of Q8 GPU).

### BLOCKED ON AJ (see [[reference_aj_handoff_doc]])
Conditional-trigger config (blocks P4 gap detection — **P2 now gives him a UI to enter it**);
whether the manual's folders 100-126 need recording; claim subject grain; **Andersen new-format
sample** (he confirmed they switched — the old-format work was correctly abandoned);
SharePoint + Cloudflare-for-PII answers from their IT.

**Two client docs drafted, UNPUBLISHED** — `~/drops/dox-data-handling-and-roadmap.md` (custody/PII
for IT+Finance) and `~/drops/aj-extraction-notes.md` (accuracy, colleague-to-colleague).
Publish via cush-tools and VERIFY the URL before sending.

---

## 2026-07-22 IDP DOCUMENT REGISTRY — LEG ONE SHIPPED TO PROD (new workstream)

Huge session. Built + shipped the **IDP Document Registry** end-to-end to prod — the
DCN-replacement / "one doc, many mappings" + **alias-driven NL retrieval** track for
Medosweet/AJ (independent of COA-fulfillment). See memory `project_idp_document_registry`
+ plan `~/.claude/plans/parsed-soaring-panda.md`.

**LIVE on supdox.com** (prod deployment `2bc192f`; 6 commits `4523639`→`2bc192f` on master,
pushed to origin):
- Migrations **0076–0079** applied to prod D1 **surgically + stamped** in d1_migrations
  (prod chain was frozen at 0063; 0064–0075 applied-but-unstamped = the known gap).
  `document_categories` junction (multi-category); `documents` += aliases/criteria/applies_to/
  owner/renewal_type/renewal_interval_months/renewal_due_date; `products` += brand_owner/
  producer/plant_code; FTS rebuilt (+category/aliases/criteria/applies_to_text; 546 rows).
- **Single-doc upload path** (`DocumentCreate.tsx`, "Add Document") — manual metadata, NO AI
  extraction, NO bulk importer (archive/old-version handling is a one-time concern, never in
  the product path — deliberate).
- **NL retrieval hardened** (the moat): bm25 weights (title 10/aliases 8/category 6),
  `natural.ts` loosen-and-retry (never returns 0), inline expiry+version, multi-category filter.
- **Renewal engine** (`functions/lib/expirations.ts`, `/api/expirations` + `/notify`, Renewals
  dashboard): renewal_type-aware status, one-click alert email to org_admins + super_admins.
  MINIMAL — no cron, no per-owner routing yet.
- **Clean Medosweet tenant** on prod (`tenant_medosweet`) + 27 starter categories (manual
  sections 100–126) via new `bin/create-tenant`. **AJ = existing super_admin**
  (`ajconner@gmail.com`) — scopes in via the tenant selector (that was his whole blocker; the
  tenant just didn't exist yet). Decided: he uses super_admin, no dedicated org_admin.

**Validated:** 200+ tests green per phase; live 10/10 verify locally (`bin/dev-demo` :8790,
a@a.a/a) incl. alias retrieval + inline expiry + multi-category. Every prod step verified.

**Corpus** at `~/drops/fsqa-seed/`: workbook (`Food_Safety_Manual___Document_Registry.xlsx`,
~101 rows) + full manual (`manual/`, 430 files). Two taxonomies surfaced: doc *class*
(SOP/Form/Log, QFD prefix, single) vs compliance *category* (sections 100–126, multi).

**Docs sent to AJ** (md/zip via cush-tools): reply (`~/drops/reply-to-aj-legone.md`),
clarifications (`~/drops/aj-clarifications.md` — AWAITING his answers), how-to
(`~/drops/medosweet-registry-howto.md`).

**OPEN / NEXT (mostly gated on AJ's clarification answers):**
- The richer **167-row catalog with aliases** if it exists (the moat fuel) — else build an
  **alias-derivation** feature (title+class+section → candidate aliases). This workbook has none.
- **Class-vs-category split** — add a single-valued doc-*class* facet alongside multi-category.
- Renewal intervals (review_cycle default; 113.2 "biannual" = 24 vs 6mo); facilities set; owner
  values beyond QA.
- Renewal fast-follows: **scheduled cron** worker + **per-owner routing** (`assignments` is the
  hook; today emails all org_admins/super_admins).
- Deferred UI: search result "vN · expires …" chip; Expirations CSV export / per-owner filter.
- `document_type_id` kept as denormalized primary-category pointer (back-compat). `bin/dev-demo`
  local D1 now has 0076–0079 applied. `dropserver.py` MAX_FILE_SIZE bumped to 2GB (for the manual).

---

## 2026-06-24 COUNTRY MORNING MATCHING SHIPPED — lot_scheme + product bridge (LIVE on prod)

Root cause = TWO per-supplier gaps (the PRODUCT one was the deeper blocker, the lot one the
obvious symptom). See memory `project_country_morning_lot_and_product_bridge`:
1. **Lot suffix:** CMF COA lots = `MMDDYY`+3char (`061626WHO`); their WMS strips to bare date
   (`061626`) → lot_keys never matched.
2. **Two-catalog product gap:** COA products are manufacturer names scoped to the supplier
   ("Milk - Whole"); orders use distributor SKUs (`0417` / "MS WHOLE 5 GL BAG") in SEPARATE
   product rows with no shared key → matcher's strong paths (lot+product / lot+code) all failed.

**Shipped to prod** (supdox.com; commits `96cdb0a`/`e0c487d`/`d9cc1e7`, pushed; deploy `470e70be`;
migration **0075** applied surgically + stamped in `_migrations`):
- `suppliers.lot_scheme` (auto|date_code|lims_combined|plain, default auto = no-op) + `applyLotScheme`
  at produce time = steady-state strip (NEW COAs need no backfill).
- `supplier_product_map` bridge (keyed by normalized COA product NAME); matcher substitutes the
  mapped `order_product_id` → strong `lot+product` (0.85). Inert when no map row.
- **Standalone "Product Mapping" tab** on SupplierDetail (teach maps for single-product COAs +
  existing data; the review-tile picker only covered multi-record COAs, which CMF's aren't).
- `bin/rectify-lot-scheme` (re-key existing lots; fixed unquoted-id bug), `bin/clone-org --from-prod`,
  `bin/{seed,verify,reprocess}-cmf-{bridge,files}` test harnesses.

**Prod result:** CMF `lot_scheme=date_code`, 88 lots re-keyed to bare dates, user taught 3 maps
(Milk-Whole→30417, Half-and-Half→0708, Heavy-Whipping→0801), rematch → 7 strong links →
tenant **1 → 8 matched**. Hands-off going forward. Validated 3 ways pre-prod (synthetic 13/13,
prod clone 1→8, full pipeline on real PDFs 15/15). Mid-flight bug fixed + regression-tested:
`produceCoa` now falls back fields→approvedFields→`ai_fields.product_name` for the
`document_products` link (single-product COAs were silently unlinked, breaking the bridge).

**LOOSE ENDS:**
- **WHY are CMF "Milk - Whole" + "Half-and-Half" products `active=0`?** Highest-volume items;
  likely an old dedupe deactivated them. Matching keys on name so it works, but investigate +
  consider reactivating / merging the active dup rows (e.g. "Half & Half" NULL-supplier active=1).
- Minor: the Product Mapping tab fires one idempotent redundant PUT (bumps `updated_at` only) on
  view because `ProductBridgeControl` calls onChange on prefill — suppress prefill-echo writes.
- The 9 still-unmatched CMF-tenant lines = genuine no-COA-on-file gaps + correct cross-product
  date-collision holds. Real lever now = **COA coverage**; they auto-match as COAs arrive.
- Worker NOT restarted (feature is Pages + migration only).
- Backlog (`backlog.md`): generalize `lot_scheme` beyond date_code (preset/regex escape-hatch) +
  **fuzzy-match auto-suggest** in the product picker (cut teach from search→confirm).

## 2026-06-11 SUBLOT GRAIN DECIDED — Option B (per-sublot) — PLAN LOCKED, NOT BUILT

**Decision (user + buddy, 2026-06-11): OPTION B.** Each sublot → its own `documents` row +
its own `lots` row (full per-sublot traceability). Extraction already emits per-sublot
records (shadow); the build pushes sublot DOWN into lots/matching/producer (main-lot-grain
today). Full design contract is in `~/.claude/plans/coa-multi-record.md` (section
"SUBLOT GRAIN LOCKED — Option B"). Key facts:
- **WMS combines lot+sublot into ONE lot, one combined lot per sublot**, CONCATENATED:
  lot `10426110` + sublot `05` → `1042611005`. So `order_items.lot_number` already carries
  the combined value → **NO order/shipment-side change**. All new work is COA-side.
- **Combine rule:** `lot_key = lot_number + sub_lot_code` (sublots are ALWAYS 2 digits, so
  verbatim concat; single-lot → `lot_key = lot_number`). Store lot_number / sub_lot_code /
  lot_key separately; matcher unchanged in shape (`product_code + lot_key`), just fed
  combined keys. Run `rematch-lots` after P4 to relink waiting order lines.
- **Deliverable = per-sublot COAs** (per-sublot page-scoped doc IS the deliverable; no
  rollup report). Sublots usually share one page → N near-identical 1-page docs, lot shows
  as N rows in the list. Confirmed acceptable.
- **Migration:** `sub_lot_code` on `lots`; identity → `(tenant_id, product_id, lot_key,
  sub_lot_code)`; main-lot rows use `''` NOT NULL (SQLite unique-index NULL trap).
- **Model:** worker going **q4 → q8** (quantization = fidelity, NOT context). KEEP
  page-first split + `mergeCoaRecords`. Watch VRAM (q8 ~2× weights; sysmem fallback = 502s).

**UI/search scope (locked 2026-06-11): NO new screens.** Review = `CoaRecordsReviewTile`
(one queue item/PDF, N sublot cards, per-sublot approve). Lots page = **flat + a `Sublot`
column** (add `sub_lot_code` to `LotListItem`; lot search also matches combined `lot_key`/
main-lot prefix). Doc detail = minor "Linked Lots" line. Fulfillment report = NO change
(already per order-line = per combined-lot = per sublot for free). **Lot search in
`documents_fts` = YES this redesign:** flatten lot_number/sub_lot_code/lot_key via
document_lots into a docs_fts lot column + normalize query (main lot → all sublots,
combined → exact) — migration + FTS reindex.

**Data migration (locked 2026-06-11):** single-lot COAs already match → leave them.
**Reprocess multi-sublot COAs ONLY** (find via shadow `ai_records` w/ ≥2 sublot records;
skip ~11 R2-404s). **Clone-rehearse: YES** — new `bin/clone-org` copies a prod org → test
tenant; rehearse Option B + reprocess there before prod.

**STATUS 2026-06-11 (pm): SHIPPED TO PROD.** Merged to `master` (`3ec395f`, pushed to
origin). Migrations **0073 + 0074 applied surgically to prod D1 + stamped** (direct
`wrangler d1 execute` + INSERT into `_migrations` — NOT bulk migrate; prod still has the
untracked 0059–0067 gap, left as-is). FTS verified healthy post-rebuild (470 rows, lot
search `lot_text:6141` → 3 COAs). **Pages deployed `ad49beb2`** (supdox.com). Option B is
LIVE. Worker unchanged (still `COA_RECORDS_MODE=shadow`, already emitting ai_records for
multi-record COAs — the deployed Pages dispatch picks those up, so multi-record COAs now
route to the new per-sublot tile + produceCoaRecords on approve).

**WMS premise: CONFIRMED by user** (Darigold/LIMS = combined lot + 2-digit sublot). Reason
prod shows zero combined-lot order lines: no Darigold orders have flowed yet (corpus orders
were Medosweet/Willamette w/ date-code or short lots — see `~/drops/dox-linkage/GROUND_TRUTH.md`).

**VALIDATED 2026-06-11 pm (throwaway prod tenant, since cleaned up):** the deployed
producer/Pages half is CORRECT on real prod — per-sublot docs, combined lot_keys
(`1042601017` etc.), composite lot identity, real page-scoped 1-page PDFs (59KB vs 79KB
7-page original). BUT found the worker (q4) does NOT emit sublot grain — it page-splits but
leaves `sub_lot_code=null` (sublots stuck in result-table columns).

**BAKE-OFF 2026-06-11 pm — Q4 vs Q8 RESOLVES THE GAP (PASS):** on EDI169211 p5 (butter
310347, 4 lot/sublot combos): OLD 4090 **Q4** (`UD-Q4_K_M`) → 0 records, sublots trapped in
column headers (the bug). NEW Mac **Q8** (`UD-Q8_K_XL`) → **4 per-sublot records**,
`sub_lot_code` 18/17/15/10, `record_cardinality=multi_lot`, `record_key_basis=lot+sublot`.
Quant bump ALONE fixes it, no prompt change needed. Q8 field naming (`sub_lot_number`/
`lot_number`) already aliased by `bin/lib/coaRecords.js`. **Live router cut over to Mac/Q8**,
so the worker now emits sublot grain in prod → Option B auto-works end-to-end.
- **CAVEAT (act on):** Q8 ~9x slower (99s vs 10s/page) + verbose (echoes test table per
  record) → worker COA `max_tokens:4096` can CLIP a many-sublot page mid-`records`. FIX:
  bump COA max_tokens (and/or stop echoing the table per record). Small worker change, do
  before heavy reliance.
- **REAL MATCH DEMO PENDING:** buddy's two flat (q4) Darigold COAs in prod tenant
  1f03c3e7 (`2235 - 1042611009.pdf`, `2235 - 1042611014 & 1042611012 & 1042611013.pdf`,
  supplier "Darigold, Inc.") cover order 1797062's sublots 09+13. Reprocess them under Q8
  (`bin/reprocess-multisublot`) → per-sublot docs → should auto-match order 1797062 per
  sublot via combined lot_key. That's the real end-to-end match proof. (WMS premise CONFIRMED
  on real data: audit #9 order 1797062 lots `1042611009`/`1042611013`.)

**OPEN FOLLOW-UPS:**
- **LIMS lot-scheme generalization (user-raised):** combined lot+sublot is a LIMS-standard
  format (common across suppliers), not Darigold-specific. Plan: per-supplier `lot_scheme`
  field (auto|lims_combined|date_code|plain; lims_combined carries sublot_digits=2/separator
  defaults) on the supplier/extraction-profile, auto-detect by pattern as pre-fill, supplier
  config pins it. Current combine rule is HARDCODED (mainlot+2-digit) — correct for Darigold,
  harmless for non-sublot suppliers (combine only fires when sublots extracted). DECISION
  PENDING: build now vs backlog.
- `rematch-lots` after real Darigold COAs/orders land (relink combined-key lines).
- bin/clone-org --prod-insert still not exercised (the e2e agent uses a fresh test tenant).
- Deferred minor: NL search (natural.ts) lot-aware; Lots-page search separator normalize;
  legacy isMultiProduct() retirement; clone-org R2 copy-vs-reuse.

Originally built + committed on branch `feat/coa-sublot-split` (`2ec5542`); build clean,
141 tests passing (coa/queue/lots/search). That commit:
- (1) FOUNDATION: migration **0073** (`sub_lot_code` on lots, composite identity, `''`
  sentinel), `produceCoaRecords` (`external_ref=queue-{id}-{lot_key}`),
  `handleCoaRecordsApprove` (partial per-record approve/hold/reject), entities/lots+matching.
- (2) UI: `CoaRecordsReviewTile` + ReviewQueue dispatch, Lots `Sublot` column,
  DocumentDetail linked-lots (added doc→lots join to documents GET).
- (3) LOT SEARCH: migration **0074** (`lot_text` in documents_fts + triggers on
  document_lots/lots changes + query normalization), reindex extended.
- (4) OPS SCRIPTS: `bin/clone-org`, `bin/reprocess-multisublot` (dry-run validated).

**IN PROGRESS (bg agent 2026-06-11):** page-scoped per-record PDF in `produceCoaRecords`
(currently whole-binary w/ P4 TODO) — extract `record.source_pages` via **pdf-lib** at
approve time, fallbacks for non-PDF/missing pages. Last code piece.

## 2026-06-12 (pm) COA GRADING PASS + Q8 WENT OFFLINE — report at ~/drops/dox-wms/COA_GRADING_REPORT.md

Graded all 19 COA rows in test tenant `a2bc46e6` vs source ground truth.
- **Q8 (mac-mini) went OFFLINE mid-pass (verified: endpoint times out).** Router failed over
  to **Q4** (`UD-Q4_K_M` on buddy/windows); live worker now on Q4. So the grading reflects
  **Q4 + the fixed prompt**, NOT Q8.
- **Prompt is CORRECT + instructions decisively load-bearing** (A/B, same model/seed): FULL
  prompt → 3 per-sublot records (14/13/12) even on Q4; MINIMAL (no tenant ctx / no Darigold
  instructions) → 0 records, sublots trapped as table headers. So per-supplier transposed-
  matrix instruction is what breaks the matrix. Single-page transposed COAs extract perfectly
  even on Q4. The first-match doc (2235) graded PASS.
- **Grades:** PASS 4 · SINGLE-OK 2(+1*) · PARTIAL-sub 6 (all lots present, single-sublot
  pages dropped `sub_lot_code` → lot_key would be bare main-lot) · PARTIAL 3 (whole-lot drops)
  · FAIL 2 (Andersen) · ERROR 1. Re-queue on Q4 did NOT fix drops (one regressed to a 502).
- **HONEST NUANCE (vs agent's "restore Q8 = the fix"):** that's an UNPROVEN hypothesis — Q8
  was offline so the multi-page bundle drops were never tested on Q8. At least two failure
  layouts are PROMPT-COVERAGE GAPS regardless of quant: (a) Andersen single-page inline
  `lot exp lot exp lot exp` triple → needs an Andersen instructions row OR a BASE rule; (b)
  "one product, TWO distinct main lots sharing a sublot column" (the 310202 pages of
  EDI169211/EDI175738) → records prompt drops the 2nd lot. Also: single-sublot pages losing
  `sub_lot_code` (PARTIAL-sub) is a recall nudge worth a prompt tweak.
- **Data hygiene:** 2 duplicate uploads (EDI169211, 2235-1042611009), 1 non-COA order-summary
  mis-filed in the COA queue.
- **NEXT (deferred, user reviewing):** 1) restore mac-mini Q8 (AJ's box — user/AJ must wake;
  I can't SSH it) then re-grade the droppers on Q8 to separate quant-vs-prompt; 2) prompt
  fixes for the 2 uncovered layouts + the single-sublot-code drop (independent of Q8);
  3) clean dupes/mis-filed. No code changed this pass — graded only.

## 2026-06-12 FIRST REAL PER-SUBLOT MATCH LANDED (full flow, test tenant)

Order **1797062** line **`1042611013`** → MATCHED to its own sublot-13 COA (doc 9b265226),
end-to-end on real data, in test tenant `a2bc46e6` ("Q8 Darigold Review", login
`q8@q8.q8`/`q8`). Line `1042611009` correctly unmatched (no COA — file gone). What it took
(all shipped + deployed to prod):
1. **Q8 (UD-Q8_K_XL on Mac)** via router — replaces q4 turbo. Fixes per-sublot recall.
2. **Worker prompt fix** (`cb6149c`): taught the TRANSPOSED sublot-COLUMN layout (a
   "Sub Lot Number 14 13 12" row + per-column test values → one record per column) +
   tightened the "omit records" caveat (multi-sublot-same-lot must NOT flatten). Without
   this, q4 AND q8 collapsed the matrix to one flat record. COA max_tokens 4096→16384.
3. **Producer fix** (`9973ec9`, deployed): `produceCoaRecords` now computes lot_key from
   `mergedFields` (page_metadata ∪ record.fields), not record.fields — lot_code is hoisted
   to page_metadata, so reading record.fields dropped the lot → null lot_key → no lots row.
4. Match path: COA approve → `linkCoaToOrders` → lot match → **lot_only suggestion** (conf
   0.5) → accepted via `POST /api/lot-matches/:id {action:accept}` → order line matched.

**OPEN — auto-confirm gap (next):** the match was lot_only/WEAK (needed human accept) because
the COA doc TITLE has no `(NNNN)` distributor-code prefix → `classifyMatch` can't strong-link
(needs order product_code `2235` === COA title `(2235)`). The distributor code lives only in
the FILENAME ("2235 - ..."), not the COA body. FIX for hands-off strong matching:
`produceCoaRecords` should derive the distributor code (from filename / source) into the doc
title as `(NNNN) ...`. Then lot+code → strong auto-confirm, no manual accept. Also: `rematch-lots`
only processes `lot_id`-bound order_items; raw-lot_number lines rely on the COA-side
`linkCoaToOrders` at approve (worked here).

**REMAINING after page-scoping (deploy/validation sequence):**
- a. Apply 0073+0074 surgically (check prod `_migrations` first — chain not re-runnable;
  prod was missing 0059–0067 untracked) + run an FTS **reindex** (lot_text backfill).
- b. Shadow-validate splits on prod (`COA_RECORDS_MODE` still shadow).
- c. **Rehearsal = PROD-INSERT isolated tenant** (user-chosen 2026-06-11; local is stale
  ~0013, staging drifted): `bin/clone-org --prod-insert` a real org → throwaway tenant,
  drive Option B review→produce→match + `bin/reprocess-multisublot`, verify lot_keys vs
  WMS lines, delete tenant.
- d. Flip `COA_RECORDS_MODE` shadow→on (new COAs split forward).
- e. `bin/reprocess-multisublot --apply` (targeted backlog) → `rematch-lots`.
- Deferred/minor: NL search (`natural.ts`) lot-aware (one-line swap); Lots-page search
  separator normalization; legacy `isMultiProduct()` retirement (now unreachable for
  records-shaped items); R2 copy-vs-reuse in clone-org (v1 reuses source keys, read-only).

**Shipped this session (all pushed to master):**
- **COA P1 page-first split** (commit `b539928`): multi-page COA PDFs are N independent
  single-page COAs bundled by PO/EDI order# — each page = one product. Worker now does
  **per-page extraction** (one LLM call/page); `bin/lib/coaRecords.js` `mergeCoaRecords`
  concatenates per-page records, NEVER merges across pages, hoists only doc-global fields
  (supplier/order#). Gated by `COA_RECORDS_MODE` (currently **shadow** on prod worker via
  systemd drop-in — emits `ai_records` alongside `ai_fields`, no reviewer impact yet).
  **Live-validated:** `EDI178057` 1 product (v1, dropped 6) → **7 products/7 lots, one per page**.
- **P2** (`12fe2fa`): `parseCoaRecords` helper + frontend type re-exports; queue GET/list
  already serve `ai_records`.
- **GPU/timeout root cause** (`4b9dbae`): `bin/qwen-proxy` hardcoded the slow 3080 and
  502'd big requests at 60s; repointed to the local **model-router** (→ 4090). Plus dox-side
  LLM timeouts raised to 300s (`12fe2fa`). Big extraction 502@60s → 200@1s.
- Removed stale connector e2e specs; `bin/coa-records-mode`, `bin/reprocess-queue` added.

**Next after sublot answer:** finalize P1 (sublot split if needed) → **P3 review UI**
(`CoaRecordsReviewTile`, per-product tiles) → P4 (per-record approval + page-scoped PDFs).
Plan: `~/.claude/plans/coa-multi-record.md`. Design notes: `COA_SPLIT_REVIEW.md` (repo root).

---

## 2026-06-02 (pm-6) MENU CONSOLIDATION + NOTIFICATIONS BELL + ASSIGNMENT/OWNERSHIP — SHIPPED PROD+STAGING

Three shipped pieces (commits `fa7ad3b`, `f760a39`; vitest 1403/1403):
1. **Menu consolidation:** left rail 22→13. Primary work items + one **Settings** entry; `Settings.tsx`
   hubs config/admin pages in grouped sections (Catalog & Sources / Access / System & Monitoring),
   reusing the existing page components (old routes kept). Help → top-bar `?` icon.
2. **Notifications bell** (`src/components/NotificationsBell.tsx`) — top-bar, generic `Notification[]`
   tray. Feed #1 = workflow approvals (Approvals moved OUT of Settings into the bell). Feed #2 =
   **assigned review items** (see #3). Merged dropdown ("Approvals" / "Needs review"), badge = sum.
3. **Assignment/ownership (Phase C core)** — migration **0071** `assignments` table
   ((tenant,supplier,doctype)→`owner_user_id`, group-ready `owner_group_id` slot; NO groups table yet —
   user confirmed "groups coming soon"). API: list/upsert(PUT)/delete + **`GET /api/queue?mine=1`**
   (items whose supplier×doctype the caller owns) powering BOTH the Review "Mine" filter and bell
   feed #2. UI: **Assignments screen** in Settings→Access (assign to a user; Groups disabled "coming
   soon"). **Verified live** on Test Lab: assigned Sunrise/COA→test user → `?mine=1` returned the 5
   Sunrise docs.

REMAINING for the owned-review-flow vision: real **maturity columns** (Phase A: maturity_state/
clean_streak + hybrid promotion — today maturity is inferred), **user GROUPS** (then wire
owner_group_id + group membership into the mine filter), order/shipment inline teach, teach
question-quality tuning (eager ready-to-synthesize + sometimes-generic opener — better w/ bigger model).

---

## 2026-06-02 (pm-5) UNIFIED CONTEXTUAL REVIEW QUEUE — teaching folded in — SHIPPED PROD+STAGING

Rebuilt review into ONE contextual surface (commit `22ebaa2`, prod+staging, vitest 1389/1389). Per
COA item: after supplier-confirm, **untaught (supplier,doctype) → two-pane: editor + inline
`TeachPanel`** (grounded interview, "Lock it in" writes the profile); **taught → lean** ("✓ using
learned profile" chip, pre-filled). Queue rows badge Taught/New. Maturity is INFERRED (profile/
instructions row exists = taught; no maturity schema yet). Reused the proven editors (multi-product/
VLM/tables/hints) + the teach engine; approve paths unchanged.
- **Retired:** standalone `/teach` page+route+nav, supplier/source Teach buttons, legacy
  `IntakeRunReview` (its staged-order data was the decommissioned sync path; SourceDetail run-link
  repointed to `/review`). Kept teach API endpoints + `src/components/teach/*`.
- **Backend adds:** resume-or-create teach session per (supplier,doctype); queue items carry
  `profile_exists`.
- **Order/shipment teach DEFERRED** (tiles unchanged for v1; can get teaching via source supplier later).
- **TEST TENANT on prod:** "Test Lab" — login `test@supdox.com` / `supdox-test-26` (org_admin,
  isolated). Upload COAs → review → untaught supplier shows teach panel inline. Delete tenant when done.
- Worker UNCHANGED (teaching+approve are Pages/Qwen).
- **FULL LOOP PROVEN LIVE on prod (Test Lab)** — I drove a session as the SME against a seeded
  "Sunrise Dairy" supplier (5 noisy COA rows): detect → interview → synthesize → confirm →
  **profile written** (real instructions: "product_code only if SKU format, not a phone number;
  normalize grade to 'Grade A'; lot_number only if LT- present" + 3 examples). Verified in
  supplier_extraction_instructions. Commit `04105b0`.
- **Bug fixed:** synthesize used to 500 (3072-token gen hit the 60s callQwenChat timeout). Now
  maxTokens 1280 + 110s timeout + fallback that drafts instructions from the SME's own answers →
  never 500s.
- **Quality follow-ups (not blockers; better w/ bigger model + prompt tuning):** opening question is
  sometimes generic (7B variance; was grounded in the Medosweet run); `ready_to_synthesize` fires too
  eagerly (buildFollowupPrompt returns KNOW_ENOUGH after ~1 answer — should cover all issues first).
- Test Lab still has the seeded Sunrise Dairy supplier + a taught profile (demo); wipe the tenant when done.

---

## 2026-06-02 (pm-4) DOCTYPES REPARENTED UNDER SUPPLIERS (hybrid) — SHIPPED TO PROD + STAGING

`document_types` now carry a nullable `supplier_id` (migration **0069**; commit `f7d341e`). HYBRID
model (user-chosen): NULL = shared/global doctype (existing rows untouched, NO document relinking);
non-null = owned by that supplier. `GET /api/document-types?supplier_id=X` returns global + X's union;
create/update accept `supplier_id`. Doctype selectors (SourceWizard/Detail, DocumentDetail,
ReviewQueue "save template") scope to the relevant supplier; SupplierDetail gained a per-supplier
"Document Types" tab; global admin page preserved. Extraction profile still keys on
`document_type_id` (unchanged). vitest **1377/0**, build clean. 0069 applied to staging + prod
(direct execute; recorded in prod `_migrations`; staging has no `_migrations` table — uses the
run-everything migrator). Worker UNCHANGED (no restart needed). Deployed: prod Pages + staging.

KNOWN/DEFERRED: doctype uniqueness stays `(tenant_id, slug)` tenant-wide → a supplier can't reuse a
global doctype's exact slug. Fits the hybrid intent (use shared, or name it distinctly). Rescope the
unique index to `(tenant_id, supplier_id, slug)` only if same-name-per-supplier is wanted later.

---

## 2026-06-02 (pm-3) CONNECTORS → SOURCES hard-cut unification — SHIPPED TO PROD + BIG-RUN VALIDATED

Big architectural pass. **Connectors are gone as a separate subsystem** — folded into the one
document-intake pipeline. State: full vitest **1371/0 green** + build clean + worker `node --check`.
**Deployed to prod** (Pages `6d6a2bb4` / supdox.com; commits `20c370c` + `6595499` on master) and
**validated by a big real-data run on staging** (fresh tenant, all doors, real Qwen extraction):
**OVERALL PASS** — 8 docs through import/run/drop/email; profile-by-(supplier,doctype) resolution +
output_kind routing confirmed live; deterministic CSV + per-sheet XLSX (Zenith late-alphabet present,
INACTIVE skipped) proven; 20 orders / 15 customers / 2 lots created; 0 worker errors. Migration 0068
applied to **staging AND prod** D1 (prod via direct `wrangler d1 execute` + recorded in `_migrations`;
prod `_migrations` only tracked through 0058, 0059–0067 were applied untracked — KNOWN GAP, reconcile
before any `bin/migrate --remote`). Re-run validation any time: `bin/big-run-validate` (see header).

GOTCHA from this session: `pkill -f process-worker` killed the PROD systemd worker; it auto-restarted
onto the new code. That's now consistent (prod Pages deployed). The prod worker was NOT cleanly
restarted via systemctl (polkit timed out — no passwordless privilege); it's running the new code and
matches prod. Companion `dox-connector-poller` Worker was redeployed (its URL moved
`/api/connectors/poll` → `/api/sources/poll`).

Bugs fixed along the way: (1) `bin/reset-staging-db` couldn't wipe (FK + FTS-trigger errors) — now
drops triggers→views→tables-reverse-order with `PRAGMA defer_foreign_keys=ON`. (2) Sources
create/update API had NO setter for the 0067 routing columns (origin/output_kind, supplier/doctype) —
UI-created sources would mis-route as COA; fixed + wired into SourceWizard/SourceDetail (commit
`6595499`).

### What changed (plan: ~/.claude/plans/cozy-bouncing-wigderson.md)
- **Hard cut:** deleted the synchronous engine `functions/lib/connectors/{orchestrator,email,
  fileWatch,index}.ts`. `executeConnectorRun` has ZERO callers. Pure CSV parse moved to
  `shared/orderParse.ts` (+ worker artifact `bin/lib/shared/orderParse.js`).
- **All doors enqueue now:** run/drop/public-link/email-webhook/retry/poll → store-to-R2 +
  `enqueueDocument` (`functions/lib/intake/enqueue.ts`) into `processing_queue` → worker → Review →
  producers. Response contract changed to `{queued, queue_id, run_id}`. Each intake writes a
  `connector_runs` rollup header (`functions/lib/intake/connectorRunHeader.ts`); counts fill at
  approve via existing `accumulateRunRollup`. Aligns with no-auto-ingest.
- **Unified extraction profile** keyed `(supplier_id, document_type_id)`: migration **0068** adds
  `field_mappings` to `supplier_extraction_instructions`; `functions/lib/extractionProfiles.ts`;
  GET/PUT `/api/extraction-instructions` carry field_mappings; profile endpoint re-keyed. Internal
  ERP/WMS = `origin_kind='internal'` supplier rows (nameless-internal backfill deferred to app level
  — see migration comment). Worker reads mappings from the profile; SourceWizard + SourceDetail both
  write mappings there now (NOT the connector row).
- **Worker gains:** deterministic CSV path (order kind, falls back to Qwen); **per-sheet XLSX
  isolation** (skips /inactive/i, merges) — fixes the dropped-late-alphabet-rows bug. COA branch
  BYTE-IDENTICAL (diff-verified).
- **Sources rebrand:** `functions/api/connectors/**` → `sources/**` (URLs `/api/sources/*`); compat
  shim left ONLY at `connectors/[id]/drop.ts` (external vendor bearer-drop). UI: Sources/SourceDetail/
  SourceWizard/IntakeRunReview; nav "Sources"; origin×output labels (`src/lib/sourceLabels.ts`).
  Public slug path `/api/public/connectors/:slug` kept stable.

### IMMEDIATE NEXT STEPS (in order — user wants all)
1. **REAL-DATA PARITY REPLAY (the actual validation — NOT done yet).** COA = low risk (byte-identical).
   Orders/CSV/XLSX = changed → must replay. Corpus in `~/drops/dox-linkage/` (8 audit-trail .docx =
   shipment, ERP/COA .pdf) exercises the order/shipment Qwen path + linkage but NOT CSV/XLSX — need a
   real order CSV + the Darigold multi-sheet XLSX to validate those. Diff resulting orders/customers/
   lots + COA-fulfillment graph against current prod.
2. **Staging E2E:** staging D1 is DRIFTED (missing migs) → re-migrate first to restore the deploy
   gate, apply 0068, deploy staging, drive every door.
3. **Prod deploy:** `bin/deploy` (Pages) + **restart `dox-process-worker.service`** (picks up CSV/XLSX
   ports + profile-by-key). Apply 0068 to prod D1 first. Small blast radius (~16 orders).
4. **Doctype reparenting (user-confirmed follow-up, task #9):** make `document_types` supplier-scoped
   (add supplier_id, migrate, rework doctype CRUD/UI + selectors). Builds on the (supplier,doctype)
   profile. Plan separately before coding.

### OPEN/WATCH
- CSV/XLSX deterministic paths have unit coverage (`orderParse.test.ts`) but NO real-file validation.
- preview-extraction is now CSV-only (non-CSV → 501); wizard live-preview still works for CSV.
- Shipment CSV stays on Qwen (parseCSVAttachment emits orders/customers, not shipments) — intentional.
- `connectors`/`connector_runs`/`connector_processed_keys` TABLE names kept (rebrand was code/UI only).

---

## 2026-06-02 SESSION WRAP — trust + review + matching + worklist (ALL SHIPPED & PUSHED)

Big, productive session. The intake → review → linkage pipeline now works **end-to-end and
human-gated**. Everything is committed AND pushed to `origin/master` (commits `6f9e115` → `9960cc9`;
origin had been 16 behind — prior sessions deployed from the tree without pushing). Prod deploys
through `c07c48ae` on supdox.com. **Worker NOT restarted — none of this needed it** (all changes
live in Pages functions; the worker still just writes `ai_records`/`ai_fields`).

### Did we remove connectors? → NO (the #1 open item)
Direction CONFIRMED with the user: connectors fold into a unified **"Sources"** admin (refactor P9)
— origin (supplier/internal) × output (coa/order/shipment), killing the connector-vs-upload
confusion. **NOT started.** Connector code/UI still exists and works; order/shipment linkage still
flows through it and there's no Sources replacement yet, so it's intentionally left running. This is
the natural next big architectural piece now that everything reviews through one queue.

### Shipped this session (in order)
1. **Supplier dedupe** — `isPlausibleSupplierName` guard (junk like `C2#`/cell-refs can't become a
   supplier); all creation funnels through `findOrCreateSupplier`; merge tool (`/admin/suppliers`
   duplicates panel + `POST /api/suppliers/merge`). Prod dups reconciled
   (`bin/reconcile-suppliers-2026-06-02.sql` — committed record). See [[project_supplier_dedupe]].
2. **NO AUTO-INGEST (deliberate — do NOT revert)** — COA docs from ALL sources always go to Review;
   templates+confidence are review-ASSIST only. Old auto-approve paths in `results.ts` removed.
   See [[project_no_auto_ingest_review_v2]].
3. **Supplier verification gate** — reviewer must confirm/correct supplier before Approve unlocks;
   admins can change supplier on existing docs (`PUT /api/documents/:id`).
4. **Kind-aware Review Queue v2** — order/shipment no longer auto-produce; editable Order/Shipment
   tiles; produce on APPROVE from reviewed `body.records`; shipment confirms weak COA→lot matches
   inline (`GET /api/lot-matches` + `POST /api/lot-matches/:id`). Kind badges + filter.
5. **docx inline preview** — `src/components/DocxPreview.tsx` (mammoth browser build) in review, doc
   detail, import. xlsx still a download card (easy SheetJS follow-up).
6. **Product-code + lot auto-matching** — order↔COA strong-link key = distributor SKU =
   `order_items.product_code` vs the **`(NNNN)` prefix of the COA TITLE** (NOT the extracted
   product_code field — that's the *manufacturer* code). `classifyMatch` new `'lot+code'` basis 0.9.
   `POST /api/admin/rematch-lots` re-runs linkage.
7. **Missing-COA worklist** — COA Fulfillment report flags each missing-COA line as **collectible**
   (we hold a COA for that code → collect this lot's COA and it auto-links) vs **none_on_file**.
   All/Needs-COA filter + summary chips + CSV export for the partner.

### THE KEY INSIGHT (drives what's next)
Matching is NOT the bottleneck — **COA lot COVERAGE is**. All 16 unlinked order lines: the product
is recognized but `coas_code_and_lot = 0` (no COA for the specific shipped lot). The matcher is
ready and auto-links the instant the right-lot COA arrives. So the operational next step is the
**partner loading real lot COAs** (following the `(NNNN)` title convention) — coverage climbs on its
own. `rematch-lots` links ~0 today; run it AFTER COAs load.

### Prod data snapshot (this session's audit)
COA: 310 approved / 81 pending / 84 rejected / ~24 error. Orders 16, order_items 17 (all lot-bound,
1 COA-linked). Lots 234. Suggestions 4 (3 pending). 343 active COA docs (6 null supplier — correctly
left for review). Errors to clean: **13 Qwen-502** (re-queue), **11 R2-404** (files gone, re-upload),
**1 legacy `.doc`**.

### Open follow-ups (prioritized; none block the loop)
1. **Connectors → unified Sources admin (P9)** — the big one (see above).
2. **Suggestions review queue** — weak matches (esp. COA-after-order) have no home outside the
   shipment tile (am chat #2; partly addressed there).
3. **Needs-COA worklist into nav** as its own landing (offered, not done).
4. **VLM for image-letterhead suppliers** — the real `C2#` accuracy fix (`QWEN_VLM_MODE` OFF in
   prod; worker-host change on the Qwen box).
5. Code-audit polish: lot/product unification (NULL-product lot → 2 rows; cosmetic, matching is
   lot_key-based), suggestion confidence-upgrade (`INSERT OR IGNORE` doesn't upgrade), COA-side
   linkage reconciliation job (linkage only at approval, errors swallowed), negative-qty (outbound)
   order lines unflagged.
6. Ingestion cleanup (the 13/11/1 errors above).
7. Order/shipment tiles never run on a FRESH real doc (the 8 pending audit-trails were produced
   earlier and re-queued → accept is idempotent). Watch a genuinely new one.

### OPS NOTES / GOTCHAS
- **SKIP_E2E used all session** — staging D1 is drifted (missing migrations). Re-migrate staging to
  restore the `bin/deploy` e2e gate.
- The **`(NNNN)` COA-title-prefix** convention is load-bearing for both the matcher and the worklist
  — ensure the partner's incoming COAs follow it.
- Endpoints added this session: `POST /api/suppliers/merge`, `GET /api/suppliers/duplicates`,
  `POST /api/admin/rematch-lots`, `GET /api/lot-matches` (+ existing `POST /api/lot-matches/:id`).

---

## 2026-06-02 (pm-2) Pipeline audit + product-code matching — SHIPPED (deploy c6ed1067 / commit f5bf383)

Ran a full prod audit of ingestion→produce→linking and shipped the product-code matcher.

**Matching fix (your #1 — auto-confirm on product-code + lot):**
- The reliable cross-side key is the **distributor SKU**: `order_items.product_code` vs the
  **leading `(NNNN)` prefix of the COA document TITLE** (e.g. `(1167) 76187-29125 CF LIQ WHOLE EGG
  LOT 6141`). NOT the COA's extracted `product_code` field — that's the *manufacturer* code
  (`76187-29125-00`) and does NOT match the order. This tripped up the original premise.
- `classifyMatch` now strong-links on code+lot (new `'lot+code'` basis, 0.9). `POST /api/admin/
  rematch-lots` re-runs linkage over existing order lines (super_admin/org_admin).

**THE KEY AUDIT FINDING — the real bottleneck is COA lot COVERAGE, not matching.** For all 16
unlinked order lines: the product IS recognized (COAs with the matching distributor code exist),
but **0 have a COA for the specific lot that shipped** (`coas_code_and_lot = 0` across the board).
The system holds COAs for *other* lots of the same products. So order→COA fulfillment is gated by
collecting the COA for each shipped lot, not by the matcher. The matcher is now ready to auto-link
them the instant they arrive. Running rematch-lots now links ~0 new (the one real match, Willamette
1167/6141, is already linked). **Next lever: a "which shipped lots are missing their COA" gap view.**

**Audit health summary:** ingestion healthy (475 COA ready w/ fields; 8 order docs correctly
pending — auto-ingest-off confirmed live). Errors: 13 Qwen-502 (transient, re-queue), 11 R2-404
(files gone, need re-upload), 1 legacy `.doc`. Produce idempotent. Integrity clean (0 dangling COA
links). Suggestions: only 4, still need a real review queue. Lots: date-code lot numbers (071626 =
a date) reused across products → lot-only stays correctly weak; code anchor disambiguates.

**Other code-audit items (not yet done):** lot/product unification (NULL-product lot vs resolved →
2 rows; cosmetic since matching is lot_key-based), suggestion confidence-upgrade on re-match
(INSERT OR IGNORE doesn't upgrade), COA-side linkage only at approval (no reconciliation job),
negative-qty (outbound) order lines not flagged.

---

## 2026-06-02 (pm) Supplier verification + NO AUTO-INGEST + kind-aware Review Queue v2 — SHIPPED TO PROD

Deploy `66233f39` / commit `6f9e115` (checkpoint also bundles the entire prior dox-core
session, which had been left uncommitted). Full vitest 1397 green; SKIP_E2E (staging drifted).

**DELIBERATE behavior changes — do NOT "fix" these back:**
- **Nothing auto-ingests anymore.** COA docs from ALL sources (upload/email/connector) now
  always go to the Review Queue. Templates + confidence are review-ASSIST only (pre-fill +
  flag). The old template-gate and tenant-confidence auto-approve paths in
  `functions/api/queue/[id]/results.ts` are gone on purpose.
- **order/shipment also require review.** They no longer auto-produce on the worker `ready`
  callback; they route to review with editable kind tiles and produce on APPROVE from the
  reviewed records (`handleRecordsApprove` reads `body.records`). Worker unchanged (still
  writes `ai_records`); no worker restart was needed for any of this.
- **Supplier verification is mandatory** in COA review: the reviewer must confirm/correct the
  supplier (SupplierAutocomplete) before Approve unlocks. `isPlausibleSupplierName` rejects junk
  (C2#, cell-refs) so garbage can't become a supplier; all creation funnels through
  `findOrCreateSupplier`. Merge tool live (`/admin/suppliers` duplicates panel + POST
  /api/suppliers/merge). Prod dup clusters already reconciled (C2#→Medosweet Farms, etc.).

**Why C2# happened (root cause):** supplier name was a LOGO image; text extraction yielded only
"C2#" + the address. Real accuracy fix for image-letterheads = VLM (`QWEN_VLM_MODE`, still OFF
in prod, worker-host change). The guard just stops junk from becoming a supplier.

**Resolved chat items from the am session:** #2 (weak COA→lot matches now confirmed inline in the
shipment tile via GET /api/lot-matches), #4 (supplier dedupe/merge tool). Review Queue v2 (the
kind-aware tiles item) is now DONE.

**Still open / next:**
- **Connectors decommission → unified "Sources" admin (P9).** User confirmed connectors are going
  away (folded into the one ingest path). Separate workstream — NOT started. This is the natural
  next big piece now that everything reviews through one queue.
- Order/shipment producers still also run on the worker `ready` path? NO — removed. But the
  `connector_runs` rollup now accrues at approve time; revisit when connectors are decommissioned.
- VLM for image-letterhead suppliers (accuracy, not just the guard).
- `bin/reconcile-suppliers-2026-06-02.sql` is a committed one-off record of the prod cleanup.

---

## 2026-06-02 "dox core" — unified intake/extraction/linkage refactor — SHIPPED TO PROD + END-TO-END VERIFIED

Huge session. Collapsed the two parallel AI-ingestion systems (COA worker + connector parser) into ONE output-kind-aware engine, added the missing order↔lot↔COA linkage, and proved it end-to-end on real production docs.

### What shipped to prod (supdox.com) + the worker (systemd, restarted on new code)
- **Migrations 0064–0067** applied to prod D1: `product_suppliers` (M2M provenance + backfill), `lots`/`document_lots`, `order_items.lot_id`/`coa_match_status`/`coa_matched_at` + `lot_match_suggestions`, and 0067 queue/connectors routing columns (`output_kind`, `source_id`, `intake_mode='sync'` default, etc.).
- **One extraction engine** (`bin/process-worker`): output-kind dispatch (`coa`/`order`/`shipment`), COA path byte-identical, **XLSX + DOCX** (mammoth — `npm install` was run on the box), multi-page chunking, **two-pass reviewer-instruction application** (re-extracts with instructions when the supplier is only resolved post-extraction). Shared order-prompt is transpiled to `bin/lib/shared/orderPrompt.js` (generated artifact; `build:worker-shared`).
- **Producers** `functions/lib/kinds/{coa,order,shipment}.ts` + dispatch in `functions/api/queue/[id]/results.ts` by `output_kind`. `kinds/shipment.ts` = the WMS hop (binds order line → lot, idempotent, handles out-of-order arrival).
- **Linkage** `functions/lib/entities/{matching,linkage,lots,products}.ts` (strong auto-link / weak suggestion). **Lot backfill** endpoint `POST /api/admin/backfill-lots` — ran it: **217 lots created (was 3), 279 doc↔lot links**.
- **Basic report** `GET /api/reports/coa-fulfillment` + "COA Fulfillment" page (definition-shaped: selector/shape/gap_rules/format).
- **Import** has a "Document kind" selector (`output_kind`).

### VERIFIED END-TO-END (real data)
`Audit Trail Report (1).docx` (output_kind=order) → order **1795128**, line "WILL CAGE FREE WHOLE LIQ", lot **6141** → matched the Willamette COA "(1167) … LOT 6141" → **report shows it linked, coverage 100%, gap=ok**. (Had to manually accept the suggestion via the API — see chat item #2.)

### CHAT ITEMS (user explicitly wants to discuss — do NOT unilaterally redesign)
1. **Matching auto-confirm.** The 6141 match was downgraded to a *suggestion* only because product NAMES differ across sides (WMS "WILL CAGE FREE WHOLE LIQ" vs COA "Willamette Cage-Free Liquid Whole Egg"). But the product **CODE 1167 is identical on both sides** (it's in the COA title and the WMS line). → tune matcher to auto-confirm on **product-code + lot** (user's "WMS clean, suppliers wonky → anchor on the clean side"). Currently `match_basis='lot_only'` conf 0.5 → suggestion.
2. **Suggested-matches queue.** There is NO UI to confirm/reject suggestions (the `POST /api/lot-matches/:id` endpoint exists; I confirmed 1795128 via API). User wants pending suggestions in a **queue**; mused a **unified queue** (COA review + order/staged review + suggestions in one place) — "might be nice, idk, let's chat." Decide the shape.
3. **Instructions.** Two-pass now applies post-extraction supplier instructions; but supplier **resolution** is fragile (worker's `/api/suppliers?search=&active=1` filter + exact/normalized name).
4. **Supplier dedupe (the "suppliers wonky" reality, live example).** Andersen had TWO records: "Andersen Dairy Inc." (was **inactive**, no instructions — what extraction resolves to) and "Anderson Dairy" (active, HAD the instructions, different spelling e/o). Fixed for now by activating "Andersen Dairy Inc." + copying instructions onto it, but they should be **merged/aliased**. Need a general supplier dedupe/merge tool.
5. **Report** supplier+exp were empty on matched rows (fix in flight — source from the COA side). Report-generator framing (basic report is the first "definition" instance; generator runs definitions as config later).

### REMAINING PHASES (the refactor plan: ~/.claude/plans/squishy-knitting-mochi.md)
- **P5–P8:** flip connector doors to async `intake_mode='queue'` (canary one low-volume connector first; reversible flag), roll out per-door/tenant, then decommission the synchronous orchestrator dispatch.
- **P9:** unified **"Sources"** admin (origin: supplier/internal, output: coa/order/shipment, clear labels — kills the connector-vs-upload confusion), report generator, lots-browse UI (built this session).
- **Review Queue v2:** kind-aware tiles (coa = fields/products/tables; order = customer+lines; shipment = order→lot bindings). Route ReviewQueue to coa; order/shipment elsewhere. Order/shipment items currently render as broken COA tiles.

### DATA/OPS NOTES
- 8 audit trails + order report + COAs in `~/drops/dox-linkage/`. Only audit #1 processed. The **docx-import allowlist fix** (in flight) lets the rest upload as `order`.
- The **order report** (COA Orders) is headers-only (no line items) → NOT a linkage source; the **audit trail** is the order+line+lot source → upload as `Order`.
- Andersen instructions now apply (verified "Reviewer instructions loaded: 1266 chars"); reprocess remaining rough Andersons to clean them (set processing_status='queued').
- WMS lots are clean (6141, date-codes like 060726); COA lots are messy → matching anchors on the WMS/clean side.

### DEPLOYS / PENDING
- DEPLOYED this session: date-format-to-local-tz, report supplier/exp fix, docx-import allowlist fix, lots-browse UI (all live on prod, verified).
- DEPLOYED (continued the session): COA Fulfillment report **clickable cells** (product → `/admin/products/:id`, supplier → `/admin/suppliers/:id`, lot → `/lots?search=`; endpoint returns supplier_id/product_id/lot_id) + **staggered-layout fix** (was a separate auto-sized table per order → now ONE fixed-layout table, header once, customer/order as group-separator rows).
- **UNCOMMITTED:** the ENTIRE session's work is uncommitted in the working tree even though it's deployed to prod (deploys build from the tree, no commit was made). Consider committing early next session so the tree has a checkpoint. `git status` will show the full picture.
- e2e gate bypassed via SKIP_E2E all session because **staging D1 is drifted** (missing migrations 0018–0063, e.g. `records_staged`) — re-migrate staging to make the gate usable again.

### COST NOTE
Enormous session (~1.3B+ tokens on 2026-06-02). Streamline next time: subagents run `node --check` + only their targeted test file (NOT the full suite); run ONE full gate before deploy.

---

## 2026-04-29 Connector intake button-up — PLANNED

Plan entered in `plan.md` at lines 667–890 covering Phases A/B/C: discoverability bring-up, three new intake paths (HTTP POST API, S3 bucket drop with auto-provisioned per-connector buckets, public drop link), and end-to-end coverage gate. SFTP and outbound pull explicitly out of scope. Estimated ~7-9 days focused work. Awaiting user redline pass before cutting Phase A's first slice.

---

## 2026-04-29 file_watch connector poller — DEPLOYED TO PROD

Both phases of the file_watch connector finish-up are committed and live
on supdox.com.

### Phase 1 (already in the tree at session start)
- Drag-and-drop manual upload zone on `ConnectorDetail.tsx` for
  `file_watch` connectors. Replaces the old broken Run-button flow.
- `api.connectors.run(id, file)` now sends `multipart/form-data` with
  the `file` field — matches what the backend already required.

### Phase 2 (this session)
- **Migration 0046** (`migrations/0046_connector_processed_keys.sql`)
  — dedup table for the scheduled poller. One row per
  `(connector_id, r2_key)` pair, written after a successful (non-
  throwing) run. Failures don't get a dedup row so they retry on the
  next tick. **Run `bin/migrate` and `bin/migrate-staging` before
  deploying.**
- **`functions/lib/connectors/pollR2.ts`** — `pollAllR2Connectors(env)`
  walks active `file_watch` connectors with a non-empty
  `config.r2_prefix`, lists R2 objects (cap 100/connector), filters
  out already-processed keys, and dispatches via the existing
  `executeConnectorRun` orchestrator. Global cap of 25 dispatched
  files per tick. Pure backend module.
- **`POST /api/connectors/poll`** — bearer-auth endpoint at
  `functions/api/connectors/poll.ts`. Allowlisted in
  `functions/api/_middleware.ts` so it bypasses JWT (the bearer
  comparison is the gate). Single-flight via a 4-minute lock row in
  `app_state` (table created lazily on first call). Returns 429 if
  another poll is in flight, 401 on bad/missing bearer, 200 with
  summary on success.
- **`workers/connector-poller/`** — companion Worker that holds the
  `*/5 * * * *` cron trigger. Cloudflare Pages can't host crons, so
  this Worker just `fetch()`es `${DOX_API_BASE}/api/connectors/poll`
  with the bearer token on every tick. Mirrors the
  `workers/sheet-session/` layout.
- **`bin/deploy-connector-poller`** — deploy script for the new
  Worker. `bin/deploy` updated with a reminder note that companion
  Workers are separate deploy artifacts.
- **UI** — added a "Remote drop" card on `ConnectorDetail.tsx` (gated
  to `file_watch`). Shows `r2://doc-upload-files/<prefix>` and the
  helper line "Upload files into this prefix — they'll be ingested
  within 5 minutes." Falls back to a muted "Configure an R2 prefix..."
  hint when none is set.
- **Tests** — `tests/api/connector-poll-r2.test.ts` (4 cases: dedup,
  inactive skip, missing-prefix skip, MAX_FILES_PER_TICK cap) and
  `tests/api/connector-poll-endpoint.test.ts` (5 cases: missing env
  var, missing/wrong/correct bearer, GET 405).

### Secrets to set BEFORE deploying
Same `CONNECTOR_POLL_TOKEN` value on BOTH sides:
1. **Pages project**: `bin/set-pages-secret CONNECTOR_POLL_TOKEN`
   (or via the Cloudflare dashboard).
2. **Worker**: `cd workers/connector-poller && npx wrangler secret
   put CONNECTOR_POLL_TOKEN`.

The Pages handler fails closed (401) if its env var is unset, so
forgetting either side just disables the poller — nothing leaks.

### Local verification end-to-end
```bash
# 1. Apply the migration locally
./bin/migrate

# 2. Spin up the dev server (uses local D1 + R2 via miniflare)
npm run dev

# 3. In another terminal: create a file_watch connector via the UI,
#    set its R2 prefix to `imports/test/`, then drop a sample CSV:
npx wrangler r2 object put doc-upload-files/imports/test/sample.csv \
  --file=./fixtures/sample.csv --local

# 4. Drive a poll tick manually (set CONNECTOR_POLL_TOKEN in
#    .dev.vars first):
curl -X POST http://localhost:8788/api/connectors/poll \
  -H "Authorization: Bearer $CONNECTOR_POLL_TOKEN"
# -> {"connectors_checked":1,"total_dispatched":1,...}

# 5. Refresh the connector detail page — a new run row appears.
# 6. Re-curl the poll endpoint — same connector returns 0 dispatched
#    (dedup confirmed).
```

### Deploy order (when ready)
1. `bin/migrate-staging` then verify on staging:
   `npx wrangler pages deploy dist --project-name doc-upload-site-staging`
2. Smoke-test the staging poll endpoint with the staging
   CONNECTOR_POLL_TOKEN.
3. `bin/deploy-connector-poller --dry-run` to validate, then deploy
   for real.
4. Set both secrets in prod, then `bin/deploy` (Pages) +
   `bin/deploy-connector-poller` (Worker).
5. Tail `npx wrangler tail dox-connector-poller` to confirm the cron
   is firing.

### Deploy outcome
- Migration 0046 applied to prod D1 directly via `wrangler d1 execute`
  (skipping `bin/migrate`'s non-idempotent path).
- `CONNECTOR_POLL_TOKEN` set on prod Pages and prod Worker, ref'd from
  `op://cush/doc-upload-site-prod/connector_poll_token`.
- Pages prod deployed; smoke-tested (200 valid token, 401 wrong token,
  405 GET).
- Worker `dox-connector-poller` deployed with cron `*/5 * * * *`;
  observed firing in `wrangler tail` (`connectors_checked: 0` because
  no connector has `r2_prefix` set yet).
- Manifest `op` ref pattern matches existing prod convention
  (`doc-upload-site-prod` item, lowercase field name).
- Two follow-up commits: `60527a6` (the bundled Phase 1+2 work),
  `03e5602` (releaseNotes test fix that unblocked the deploy).

### Still pending — for the next conversation
- **Email connector polish.** That's the topic for the follow-up
  session. Phase 2 deliberately ignored email; the existing
  `/api/webhooks/connector-email-ingest` flow stays as-is for now.
- The CLAUDE.md migrations table is still missing rows 0023-0045 (only
  0046 was added this session, since that was what the new work
  introduced). Backfilling the rest is a low-priority cleanup.

---

## 2026-04-17 Prod Deploy — LIVE on supdox.com

Promoted the full session's work from staging to production.

### What's now live in prod (commit 9d09b0e -> a91e11f, 17 commits)
- **VLM extraction fields** (migration 0034) — `vlm_*` columns on
  `processing_queue` ready to receive dual-mode results. **`QWEN_VLM_MODE`
  on the prod worker is still `off` — flip to `dual` when ready.**
- **Per-supplier extraction instructions** (migration 0035 +
  `supplier_extraction_instructions` table) — reviewer textarea on
  `/queue/:id`, autosaves, prompt injection wired in `bin/process-worker`.
- **Tinder-style A/B eval** (migration 0036 + `extraction_evaluations`
  table) — `/eval` and `/eval/report` routes live. Will only show
  eligible items once the prod worker runs in `dual` mode.
- **Connector soft-delete** (migration 0037 + `connectors.deleted_at`) —
  Drafts vs deleted now disambiguated in the list.
- **Connector stabilization** — webhook column fix, draft list visibility,
  wizard edit rehydrate, file_watch manual upload runner, live test
  probes per connector type.
- **Playwright e2e gate** — `bin/e2e` runs vitest (707 tests) + playwright
  (10 tests against staging) in ~1m20s. `bin/deploy` now auto-gates on it.
- **API regression coverage** — +18 vitest cases for ingest, email
  webhook, search, versioning.

### Prod deploy details
- **Pre-flight**: vitest 707/707, playwright 10/10 — all green
- **Migrations applied to prod D1**: 0034, 0035, 0036, 0037 (only the four
  new ones; 0023-0033 were already on prod from prior sessions)
- **Staging deployment**: `045b76b8.doc-upload-site-staging.pages.dev`
- **Prod deployment**: `51e5ad80.doc-upload-site.pages.dev` (custom
  domain: https://supdox.com)
- **Prod data integrity**: documents=113, processing_queue=183 — both
  match pre-deploy counts (no data loss)
- **Prod worker**: PID 3319237 still running uninterrupted (3+ days
  ETIME). **Not restarted**, by design. The new code paths (instruction
  injection, VLM dual mode) only activate when the worker picks up the
  new code, which happens on its next restart. Until then, prod
  continues running the prior worker code unchanged.

### What the user needs to decide next
1. **Restart prod worker** when ready to start ingesting prod COAs
   through the new instruction-injection path. Set
   `QWEN_VLM_MODE=dual` on the worker host (`192.168.1.67`) before
   restart if you want VLM dual-extraction to start populating prod
   `vlm_*` columns. Without that, instruction-injection still works for
   text-mode extractions.
2. **A/B eval in prod** is wired but blank until the worker runs dual
   mode — there are zero eligible items right now in the prod DB.
3. **`bin/migrate` is still not idempotent** — it tried and failed at
   0006 because prod was already past it. We applied 0034-0037 directly
   via `wrangler d1 execute`. Worth fixing `bin/migrate` to mirror
   `bin/migrate-staging`'s `(tolerated: ...)` logic so future prod
   migrations can re-run safely.

---

## Tinder-Style A/B Evaluation (2026-04-17)

Blind-compare eval flow for text vs VLM extraction so the partner can pick a
winner per document and we can measure reviewer preference at the
supplier + doctype level. **Now live in both staging and prod.**

### URLs
- Staging: https://doc-upload-site-staging.pages.dev/eval
- Prod: https://supdox.com/eval
- Login (staging): `a@a.a` / `a` (from `STAGING_CREDENTIALS.md`)

### Status
- Migration 0036 applied to both staging and prod D1.
- Prod has zero eligible items until the prod worker runs in `dual` mode.
- Staging smoke test passed: login → `/api/eval/next` returns an eligible
  item with a random `a_side` → POST `/api/eval/:id` upserts → `/api/eval/report`
  aggregates. Smoke-test row was cleaned out of the DB.

### Surfaces
- Table: `extraction_evaluations (id, queue_item_id, evaluator_user_id,
  winner, a_side, comment, evaluated_at)` with UNIQUE on
  `(queue_item_id, evaluator_user_id)`.
- API: `GET /api/eval/next`, `POST /api/eval/:queue_item_id`,
  `GET /api/eval/report`. All tenant-scoped via `requireTenantAccess`.
- Aggregator: `functions/lib/evalAggregate.ts` — pure function, unit-tested
  separately from the DB layer.
- UI: `src/pages/Eval.tsx` (full-screen flow) + `src/pages/EvalReport.tsx`
  (results dashboard with CSV export). Routes wired into `src/App.tsx`,
  nav item "A/B Eval" added to `src/components/Layout.tsx` for
  super_admin / org_admin / user.

### Load-bearing blindness
The `a_side` column is the only place text-vs-VLM identity lives post-GET.
The `/eval` page launders both payloads through a randomizer before
rendering — no "text" / "vlm" strings are emitted in DOM attributes or
class names for the Method A / Method B cards. The report unblinds using
`resolveWinningSide(winner, a_side)`.

---

## Phase 1: Smart COA Intake — COMPLETE (2026-04-08)

All Phase 1 features are live on supdox.com.

### What's working
- Upload → queue → Qwen AI extraction → human review → ingest
- Per-supplier+doctype extraction templates (auto-maps fields after first review)
- Auto-ingest when template exists + confidence gates pass
- Email ingestion at {slug}@supdox.com via CF Email Worker
- AI natural language search (fuzzy products/suppliers, expiration queries, metadata filters, relevance ranking)
- Product name autocomplete in review/import
- OCR fallback via tesseract for scanned PDFs and standalone images
- Auto-rotation detection for sideways/upside-down scans (tesseract OSD + ImageMagick)
- Manual rotate button in PDF viewer and image previews
- Few-shot extraction examples — corrections improve future extractions per supplier
- Full table review: editable cells, add/delete rows and columns, include/exclude tables and columns
- Re-extract from text (paste text for AI re-parsing, or re-queue for reprocessing)
- Notes field per queue item
- Field dismiss (X button moves to extended metadata, restore option)
- Source tracking on queue items (import/email/api with sender details)
- Result notification emails for email-sourced docs (auto-ingested → summary, needs review → link)
- Import page is fire-and-forget (queue and go, check Review Queue later)
- Ingest History page shows full pipeline journey (source, processing status, confidence, template match)
- Supplier management pages (list + detail with products, templates, documents tabs)
- Products linked to suppliers via supplier_id
- Template management on supplier detail page (edit field mappings, auto-ingest settings)

### Bug fixes applied
- Soft-deleted items hidden by default in list endpoints
- Boolean active values coerced to integer on update
- Seed script generates proper PBKDF2 password hash
- Query param standardized to tenant_id (snake_case) everywhere
- Process worker: 6K text trim (was 12K), staleness recovery for stuck items
- Aliases parsing handles both string and array formats

### UI cleanup
- Upload removed from nav (Import is the only intake path)
- Bundles hidden from nav (backend stays for future Phase 5)
- Products removed from nav (managed via Supplier detail page)
- Suppliers in admin nav above Document Types

### Known remaining items
- FTS5 migration (Phase 2 of search) — for when document count grows
- Email ingest log not written to DB (worker lacks D1 bindings, logs to console)
- Process worker not managed by systemd (runs as background process)
- Table edits and column excludes not persisted to backend on approve (visual only during review)
- Notes field not persisted to backend on approve

### Qwen proxy
- Runs on port 9600 locally (or 9601 via auth proxy)
- Secret in `.qwen-proxy-secret` (gitignored)
- Cloudflare Pages secrets: QWEN_URL + QWEN_SECRET
- Worker needs restart to pick up code changes to bin/process-worker

---

## Domain setup
- App: https://supdox.com (CF Pages, custom domain)
- Email: {slug}@supdox.com (CF Email Routing → dox-email-worker)
- Legacy: dox.cush.rocks still works (CNAME to Pages)
- DNS: supdox.com on Cloudflare, cush.rocks on name.com
- Resend verified for noreply@supdox.com

---

## Phase 2: Connector System, Orders, Customers — LIVE (2026-04-17)

Phase 2 is deployed to prod. Connector stabilization pass also live (see
the 2026-04-17 prod deploy section above).

### Also completed (order search)
- Enhanced order list search covers all fields (order number, PO, customer name/number, product names, lot numbers) via LIKE queries
- Natural language order search implemented (POST /api/orders/search/natural) — AI-powered via Qwen
- Search page has Documents/Orders tabs, both with regular and AI search modes

### Follow-up items to consider (Phase 3)
- Order-to-COA auto-matching — automatically match order items to existing COA documents by product + lot

---

## Per-Supplier Extraction Instructions — LIVE (2026-04-17)

Reviewers can now type plain-English guidance per (supplier, document_type) that
gets prepended to the Qwen system prompt on every future extraction of that
pair. Sits alongside the existing silent few-shot loop — this is the explicit
"teach the model" surface that reviewers can see and edit.

### Status
- Migration 0035 applied to both staging and prod D1.
- Deployed to staging (`doc-upload-site-staging.pages.dev`) AND prod
  (`supdox.com`).
- **Prod worker not restarted** — the prompt-injection wiring lives in
  `bin/process-worker` and only takes effect after the next worker
  restart. Until then, prod ingest still runs the previous worker code.

### Surfaces
- Table: `supplier_extraction_instructions` (supplier_id + document_type_id
  UNIQUE — one row per pair per tenant).
- API: `GET /api/extraction-instructions?supplier_id=X&document_type_id=Y`
  and `PUT /api/extraction-instructions` (upsert).
- UI: textarea below the VLM compare panel in `ReviewQueue.tsx`. Autosaves
  500ms after the user stops typing; flushes on blur. Only renders when
  both supplier + document_type are resolvable on the queue item.
- Worker: `bin/process-worker` now resolves `item.supplier` → supplier_id,
  looks up instructions, and prepends them to both the text and VLM system
  prompts via `prependReviewerInstructions()`.

### Leaves alone
- Per-item `notes` field in the review queue — that's a reviewer scratchpad,
  separate from this teach-the-model surface.
- Existing few-shot `extraction_examples` — those are silent field-level
  corrections, still work as-is.

---

## VLM Extraction Upgrade — LIVE (2026-04-17)

Adds a Vision-Language Model (Qwen2.5-VL-7B) extraction path that runs alongside the existing text/OCR pipeline, plus a side-by-side review UI for reviewers to pick the better result per field.

### What it does
- New `QWEN_VLM_MODE` env on the process worker: `off` (default), `dual` (run both paths, store both), `vlm` (VLM only).
- Dual mode renders PDF pages to PNG (scale 2.0, capped at `QWEN_VLM_MAX_PAGES=5` for VRAM safety) and sends them to the VLM endpoint, storing the result in new `vlm_*` columns on `processing_queue`.
- Review Queue UI shows a side-by-side compare panel when both extractions exist — per-field source picker (text vs vlm), match/differ/text-only/vlm-only summary badge, then merges the user's picks on approve.
- `selected_source` is recorded in the audit log so we can later measure reviewer preference.

### Files changed (high level)
- Migration `0034_vlm_extraction_fields.sql` — adds `vlm_extracted_fields/tables/confidence/error/model/duration_ms/extracted_at` columns to `processing_queue`. **Applied to prod D1 on 2026-04-17.**
- `bin/process-worker` — VLM config wiring, PDF-to-PNG renderer with safety guards (rejects <100-byte PNGs to avoid the GGML_ASSERT 2x2-pixel CLIP crash seen on the Windows GPU host), prompt builder, dual-run control flow.
- `src/pages/reviewVlmDiff.ts` + `reviewTableActions.ts` — extracted as pure modules so the diff/merge and table-edit logic are unit-testable without React.
- `src/pages/ReviewQueue.tsx` — compare panel, source picker, merge-on-approve.
- `functions/api/queue/[id].ts`, `functions/lib/queue-approve.ts`, `functions/api/queue/[id]/results.ts` — accept `selected_source`, expose VLM payload to frontend.
- `shared/types.ts` + `src/lib/types.ts` — VLM fields on `ProcessingQueueItem`.
- New tests: `tests/api/queue-approve-vlm.test.ts`, `tests/api/queue-results-vlm.test.ts`, `tests/unit/processWorkerVlm.test.ts`, `tests/unit/reviewVlmCompare.test.ts`, `tests/unit/reviewTableActions.test.ts`.

### Status
- Code complete, all tests passing.
- Migration 0034 applied to prod D1.
- **VLM stays off in production until `QWEN_VLM_MODE=dual` is flipped on the
  worker host (Qwen GPU box at 192.168.1.67) and the worker is restarted.**
  Default behaviour is unchanged — prod continues running text-only
  extraction until you flip the switch.

### Connector flow
- End-to-end working in staging and prod (see "2026-04-17 Prod Deploy" at top).
- Playwright e2e harness covers the full file_watch loop.

---

## E2E Gate in Place (2026-04-17)

Playwright is wired up. Run `./bin/e2e` before prod deploys — it's also
invoked automatically as a pre-flight step inside `bin/deploy` (bypass
with `SKIP_E2E=1` for emergencies only).

### What's covered
Phase 2 tests exercise: auth (login/bad-pw/logout), smart upload →
queue, review-approve → document, connector wizard (file_watch full
create-run-probe-delete loop), A/B eval (partner winner pick + report
count), and admin smoke (supplier / doctype / user CRUD).

API regression adds: document ingest upsert, email webhook shapes
(Mailgun + SendGrid), documents search (LIKE + supplier filter), and
document versioning (v1+v2 via ingest, download per version).

### Numbers
- Vitest: 707 tests (was 689; +18 new API cases)
- Playwright: 10 tests (chromium only)
- `bin/e2e` total runtime: ~1m20s clean

### CI
`.github/workflows/test.yml` now has two jobs: `vitest` runs on every
push/PR; `e2e` runs Playwright on push-to-master and manual dispatch.
Traces upload as artifacts on failure.

### Known test gotchas for future sessions
- `tests/e2e/.auth/` is gitignored — tokens are regenerated every run
  by `global-setup.ts`.
- The review-approve spec tolerates 500s from the approve endpoint when
  the document for `queue-${item.id}` already exists (external_ref
  collision from a prior run). It falls back to verifying the
  document pipeline by querying `/api/documents/lookup`.
- The smart-upload spec drives the MUI Tenant Select via keyboard
  (`space` / `ArrowDown` / `Enter`) because there are two combobox
  elements both labeled "Tenant" (drawer filter + page select).

---

## Cloudflare Staging Environment (2026-04-17)

Staging is a **second, fully-isolated Pages project** (NOT a prod preview env).

### Resources
- Pages project: `doc-upload-site-staging`
- URL: https://doc-upload-site-staging.pages.dev
- D1: `doc-upload-db-staging` (separate id from prod)
- R2: `doc-upload-files-staging`
- Env vars on the project: `JWT_SECRET` (fresh, staging-only), `RESEND_API_KEY`, `QWEN_URL`, `QWEN_SECRET`

### Credentials
- Admin email + password are in `STAGING_CREDENTIALS.md` at the repo root (gitignored).
- Re-run `./bin/seed-staging` to rotate them.

### Operating
- Deploy: `npm run deploy:staging` (or `./bin/deploy-staging`)
- Migrate: `npm run migrate:staging` (runs all `migrations/*.sql` against staging D1, `--remote`)
- Seed admin: `./bin/seed-staging`
- Clean slate: `./bin/reset-staging-db` (drops all tables, re-runs migrations, does NOT seed)

### Deploy internals
`bin/deploy-staging` temporarily swaps `wrangler.toml` with `wrangler.staging.toml`
(which has the staging D1 id + R2 bucket), runs the Pages deploy, then restores
the prod `wrangler.toml` on exit. This is required because `wrangler pages deploy`
uploads the bindings from `wrangler.toml` and doesn't support a `--config` flag.

### Migration quirk
Migrations 0015 creates `email_domain_mappings`, 0017 drops it, 0020 ALTERs it.
Prod was fixed by manually recreating the table; `bin/migrate-staging` does the
same recreate step automatically before 0020.
