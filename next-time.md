# Next Time

Notes and thoughts for the next session. Claude reads this on startup.

---

## Tinder-Style A/B Evaluation — STAGING ONLY (2026-04-17)

Blind-compare eval flow for text vs VLM extraction so the partner can pick a
winner per document and we can measure reviewer preference at the
supplier + doctype level.

### URLs
- Eval: https://doc-upload-site-staging.pages.dev/eval
- Report: https://doc-upload-site-staging.pages.dev/eval/report
- Login: `a@a.a` / `a` (staging admin from `STAGING_CREDENTIALS.md`)

### Status
- Migration 0036 applied to `doc-upload-db-staging` only — prod untouched.
- 8 of the 31 staged COAs are currently eligible (both text and VLM
  extractions ready, no VLM error). Remaining items will surface as the
  process worker finishes dual-mode runs.
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

### To validate in staging
- Click through `/eval`, pick winners on the 8 ready items.
- Confirm `/eval/report` shows a sensible breakdown — Country Morning
  Farms is the supplier for most docs in the current batch.
- Export CSV, verify `a_side` and `winning_side` columns are consistent.
- Wait for the rest of the 31 COAs to finish dual-mode extraction;
  re-visit `/eval` and confirm the counter picks them up.

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

## Phase 2: Connector System, Orders, Customers — CODE COMPLETE (2026-04-09)

Phase 2 is code-complete and ready for testing.

### Before deploying
- Migration 0030 applied locally — run `npm run migrate:remote` for production
- Test plan at `test-plan-phase2.md` — follow it to verify everything works
- After testing passes, deploy with `./bin/deploy`

### Also completed (order search)
- Enhanced order list search covers all fields (order number, PO, customer name/number, product names, lot numbers) via LIKE queries
- Natural language order search implemented (POST /api/orders/search/natural) — AI-powered via Qwen
- Search page has Documents/Orders tabs, both with regular and AI search modes

### Follow-up items to consider (Phase 3)
- Order-to-COA auto-matching — automatically match order items to existing COA documents by product + lot

---

## Per-Supplier Extraction Instructions — STAGING ONLY (2026-04-17)

Reviewers can now type plain-English guidance per (supplier, document_type) that
gets prepended to the Qwen system prompt on every future extraction of that
pair. Sits alongside the existing silent few-shot loop — this is the explicit
"teach the model" surface that reviewers can see and edit.

### Status
- Migration 0035 applied to `doc-upload-db-staging` only — prod is still
  untouched. Run `npm run migrate:remote` when the feature is validated in
  staging.
- Deployed to `doc-upload-site-staging.pages.dev`.
- Staging process worker restarted and picked up the new prompt injection
  wiring (VLM mode: dual).

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

### To validate in staging
- Approve a COA, write instructions like "COAG values go in column A, not B"
  against the review queue textarea.
- Re-queue another doc from the same supplier + doctype and confirm
  `Reviewer instructions loaded: N chars` appears in the worker log.
- Check extraction improves after guidance.

---

## VLM Extraction Upgrade — CODE COMPLETE (2026-04-16)

Adds a Vision-Language Model (Qwen2.5-VL-7B) extraction path that runs alongside the existing text/OCR pipeline, plus a side-by-side review UI for reviewers to pick the better result per field.

### What it does
- New `QWEN_VLM_MODE` env on the process worker: `off` (default), `dual` (run both paths, store both), `vlm` (VLM only).
- Dual mode renders PDF pages to PNG (scale 2.0, capped at `QWEN_VLM_MAX_PAGES=5` for VRAM safety) and sends them to the VLM endpoint, storing the result in new `vlm_*` columns on `processing_queue`.
- Review Queue UI shows a side-by-side compare panel when both extractions exist — per-field source picker (text vs vlm), match/differ/text-only/vlm-only summary badge, then merges the user's picks on approve.
- `selected_source` is recorded in the audit log so we can later measure reviewer preference.

### Files changed (high level)
- Migration `0034_vlm_extraction_fields.sql` — adds `vlm_extracted_fields/tables/confidence/error/model/duration_ms/extracted_at` columns to `processing_queue`.
- `bin/process-worker` — VLM config wiring, PDF-to-PNG renderer with safety guards (rejects <100-byte PNGs to avoid the GGML_ASSERT 2x2-pixel CLIP crash seen on the Windows GPU host), prompt builder, dual-run control flow.
- `src/pages/reviewVlmDiff.ts` + `reviewTableActions.ts` — extracted as pure modules so the diff/merge and table-edit logic are unit-testable without React.
- `src/pages/ReviewQueue.tsx` — compare panel, source picker, merge-on-approve.
- `functions/api/queue/[id].ts`, `functions/lib/queue-approve.ts`, `functions/api/queue/[id]/results.ts` — accept `selected_source`, expose VLM payload to frontend.
- `shared/types.ts` + `src/lib/types.ts` — VLM fields on `ProcessingQueueItem`.
- New tests: `tests/api/queue-approve-vlm.test.ts`, `tests/api/queue-results-vlm.test.ts`, `tests/unit/processWorkerVlm.test.ts`, `tests/unit/reviewVlmCompare.test.ts`, `tests/unit/reviewTableActions.test.ts`.

### Also bundled in this commit
- **Unified Activity feed** — new `/api/activity` + `/api/activity/event` endpoints and Activity page that merge connector runs, document ingests, orders, and audit log into one timeline. Backed by `functions/lib/activityMerge.ts` (pure merge/sort/paginate) with full unit + API test coverage.
- **Connector flow tightening** — wizard/CRUD/test-connection improvements. Stabilization of these flows is the focus of the next session.

### Status
- Code complete, all new tests added.
- Awaiting full `npm test` run + deploy.
- Migration 0034 is local-only — run `npm run migrate:remote` before deploy.
- VLM stays off in production until `QWEN_VLM_MODE=dual` is flipped on the worker host (Qwen GPU box at 192.168.1.67); default behaviour is unchanged.

### Next session focus
- Stabilize / bug-fix the connector flow (wizard, schema discovery, field mapping v2, preview extraction, test-connection, runs).

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
