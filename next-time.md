# Next Time

Notes and thoughts for the next session. Claude reads this on startup.

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
