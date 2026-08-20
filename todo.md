# Todo

## Upcoming

- Spec limits — discovery for unmatched analytes. A printed test name that matches no configured analyte is counted per COA but there is no tenant-wide view of "tests we see often and hold no limit for". `bin/recheck-spec-limits` reports it; the Spec Limits admin page should too, so the alias gap is fixable without a CLI.
- Spec limits — product-scoped limits. The column exists (mig 0084) but the admin UI does not offer it: the review queue cannot resolve a document's products at review time, so such a limit would list as active and never fire. Needs product resolution at review time first (supplier_product_map / ProductBridgeControl).
- Spec limits — retroactive register backfill. `bin/recheck-spec-limits` reports over approved documents but does not write `document_spec_checks` rows; that would mean a write path outside `bin/lib/d1.js`'s read-only guarantee. Decide whether history is worth it, and whether a backfill should suppress alerts (it must).

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
