# Todo

## Upcoming

- Full-text content search — extract text from PDFs on upload, index with Cloudflare Vectorize for semantic search ("find docs about emissions compliance")
- Auto-categorization — AI classifies uploaded docs into document types/tags automatically on upload (moved to plan.md — covered by Smarter Extraction Phase 1.3 doctype promotion)
- Document summarization — AI-generated summary shown on each document detail page
- Cron trigger for expiration alerts — configure Cloudflare Workers Cron to call POST /api/expirations/notify daily
- Bundle size guard — pre-generate large bundles (>50MB) to R2 instead of in-memory ZIP
- Order-to-COA auto-matching (Phase 3) — automatically match order items to existing COA documents by product + lot
- Document Search v2 — universal, faceted, FTS5-backed (moved to plan.md — see "Document Search v2")

## Documents list maturity

- Product filter on documents list — multi-select chip filter alongside supplier/doctype, server-side join on document_products (src/pages/Documents.tsx, functions/api/documents/index.ts)
- Bulk archive/delete — checkbox-select mode + action bar; new PATCH /api/documents/bulk taking {ids, status}
- Archived tab + restore — separate tab to view archived docs with restore-to-active button (pairs with bulk archive)
- Pre-populate supplier/doctype on re-upload — new-version form should default to current document's supplier and doctype instead of resetting
- Version selector metadata — DocumentDetail version dropdown should show filesize, upload date, uploaded_by, and change_notes snippet

## Refactors

- Consolidate MIME allowlist — ALLOWED_TYPES + MIME_TO_EXTENSIONS duplicated in functions/api/documents/[id]/upload.ts and functions/api/documents/ingest.ts; move to functions/lib/validation.ts
