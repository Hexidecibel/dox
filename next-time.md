# Next Time

Notes and thoughts for the next session. Claude reads this on startup.

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
