# Todo

## Upcoming

- **Spec limits — gap detection ("we hold a Listeria limit, this COA never reported one").** Does not exist; `unmatched` is strictly the reverse direction. THE finding for a supplier under a sanitation alert: Andersen tests for two organisms and so returns a clean register by default. **NOT blocked on AJ** — the subtraction logic, the supplier satisfied/open view and the countable "unclassified" state are all buildable now against an empty config; his rows are DATA that loads into `supplier_requirements` (mig 0087) later. Build it empty, seed plausible rows ourselves, give him a screen to correct.
- Spec limits — discovery for unmatched analytes in the UI. `bin/recheck-spec-limits` reports it and that report just produced a measured 8-spelling / 515-result gap for AJ; the Spec Limits admin page should show the same, so the alias gap is fixable without a CLI.
- Spec limits — the API and the importer disagree on when `version` bumps. `functions/api/spec-limits/[id].ts:75` bumps on EVERY edit (including a notes-only change); `bin/lib/specLimitsImport.js` bumps only when operator/value/unit actually move. AJ's own change rule is "changing a limit value requires a new version", which matches the importer. Pick one semantic — the register freezes `version` into `limit_snapshot`, so this is audit-trail wording, not cosmetics.
- Spec limits — surface `control_rows` in the review tile. The engine returns it (Buffer/blank/control rows excluded from product verdicts) but `functions/lib/spec-warnings.ts` builds its summary from `.verdicts` and `.unmatched` only, so a reviewer cannot see that a control row was recognised and skipped.
- Spec limits — product-scoped limits. The column exists (mig 0084) but the admin UI does not offer it: the review queue cannot resolve a document's products at review time, so such a limit would list as active and never fire. Needs product resolution at review time first (supplier_product_map / ProductBridgeControl).
- Spec limits — retroactive register backfill. `bin/recheck-spec-limits` reports over approved documents but does not write `document_spec_checks` rows; that would mean a write path outside `bin/lib/d1.js`'s read-only guarantee. Decide whether history is worth it, and whether a backfill should suppress alerts (it must). NOTE: distinct from `bin/backfill-coa-extended-metadata`, which is done.
- Spec limits — crosstab detection requires `spec === -1`, but `detectTableShape` partial-matches spec synonyms over 3 chars, so a header like `Standard Plate Count` claims the spec slot via `standard` and that table is still skipped. No corpus shape hits it today; widen by allowing `spec !== -1` when the spec-matched header itself matches a configured analyte.
- **Build — the functions project is not typechecked at all.** `npx tsc --noEmit` is a NO-OP (root tsconfig is `files: []` + project references, which `--noEmit` does not build), and `npm run build` only builds `tsconfig.app.json`. Real check is `npx tsc -p tsconfig.functions.json --noEmit`: **64 pre-existing errors**. Wire it into CI and burn the baseline down.
- **Prompt twins have no mirror test.** `DAIRY_FOOD_INDUSTRY_PROMPT` in `bin/process-worker` and `INDUSTRY_PROMPTS.DAIRY_FOOD` in `functions/lib/llm.ts` are hand-maintained copies that can silently diverge. `bin/lib/models.js` has exactly this hazard and IS covered by a mirror test — follow that pattern.

- Full-text content search — extract text from PDFs on upload, index with Cloudflare Vectorize for semantic search ("find docs about emissions compliance")
- Auto-categorization — AI classifies uploaded docs into document types/tags automatically on upload (moved to plan.md — covered by Smarter Extraction Phase 1.3 doctype promotion)
- Document summarization — AI-generated summary shown on each document detail page
- Cron trigger for expiration alerts — configure Cloudflare Workers Cron to call POST /api/expirations/notify daily
- Bundle size guard — pre-generate large bundles (>50MB) to R2 instead of in-memory ZIP
- Order-to-COA auto-matching (Phase 3) — automatically match order items to existing COA documents by product + lot
- Document Search v2 — universal, faceted, FTS5-backed (moved to plan.md — see "Document Search v2")
- Rejection notes → extraction learning — reviewer rejection feedback never reaches the LLM. Rejection handler at functions/api/queue/[id].ts:314-352 only sets status / deletes R2 / logs audit; no notes field on processing_queue. Two options: (a) add a notes column to processing_queue and plumb into the extraction few-shot prompt, or (b) wire rejection notes into the existing `supplier_extraction_instructions` table (mig 0035) so they apply per-supplier going forward. Decide in /plan.
- Multi-page PDF preprocessing for extraction — LLM extraction gets confused by multi-page PDFs in the webhook ingest + queue extract paths. functions/lib/extract.ts uses `mergePages: true` (single concatenated blob), while functions/lib/connectors/email.ts:204+ already chunks PDFs page-by-page (working pattern). Extend the connector's per-page chunking to extract.ts, or add a page-split preprocessing step in the queue worker before the LLM call.
- Qwen cold-start 502 hardening — recurring root cause of queue items going to `error` (today: Darigold, 76187 product specs, 339209, 339028). Worker currently does 2 retries × 60s backoff inside `bin/process-worker`; not enough against the RTX 3080's tight-VRAM cold load. Options: (a) bump retries/backoff, (b) add a model-warmup probe before dispatching the real call so we wait-out the cold start, (c) keepalive ping every N minutes from the worker to keep the model resident. (b) is probably the right shape — single source of cold-start handling, doesn't waste GPU when idle.

## Documents list maturity

- Product filter on documents list — multi-select chip filter alongside supplier/doctype, server-side join on document_products (src/pages/Documents.tsx, functions/api/documents/index.ts)
- Bulk archive/delete — checkbox-select mode + action bar; new PATCH /api/documents/bulk taking {ids, status}
- Archived tab + restore — separate tab to view archived docs with restore-to-active button (pairs with bulk archive)
- Pre-populate supplier/doctype on re-upload — new-version form should default to current document's supplier and doctype instead of resetting
- Version selector metadata — DocumentDetail version dropdown should show filesize, upload date, uploaded_by, and change_notes snippet

## Refactors

- Consolidate MIME allowlist — ALLOWED_TYPES + MIME_TO_EXTENSIONS duplicated in functions/api/documents/[id]/upload.ts and functions/api/documents/ingest.ts; move to functions/lib/validation.ts
