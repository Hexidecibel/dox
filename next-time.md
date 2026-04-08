# Next Time

Notes and thoughts for the next session. Claude reads this on startup.

---

## Phase 1: Smart COA Intake — COMPLETE (2026-04-07)

All Phase 1 features are live on supdox.com:

### What's working
- Upload → queue → Qwen AI extraction → human review → ingest
- Per-supplier+doctype extraction templates (auto-maps fields after first review)
- Auto-ingest when template exists + confidence gates pass
- Email ingestion at {slug}@supdox.com via CF Email Worker
- AI natural language search (fuzzy products/suppliers, expiration queries, metadata filters, relevance ranking)
- Product name autocomplete in review/import
- OCR fallback via tesseract for scanned PDFs
- Extraction examples saved on every correction (feedback loop for improving quality)

### Bug fixes applied
- Soft-deleted items now hidden by default in list endpoints
- Boolean active values coerced to integer on update
- Seed script generates proper PBKDF2 password hash
- Query param standardized to tenant_id (snake_case) everywhere

### Known remaining items (non-blocking)
- FTS5 migration (Phase 2 of search upgrade) — for when document count grows
- Email ingest log not written to DB (worker lacks D1 bindings, logs to console only)
- Process worker not managed by systemd (runs as background process)
- Prompt tuning improves automatically as users review/correct more documents

### Qwen proxy
- Auth proxy runs on port 9601, tunneled to qwen.cush.rocks (or qwen.tunnel.cush.rocks)
- Secret stored in `.qwen-proxy-secret` (gitignored)
- Cloudflare Pages secrets: QWEN_URL + QWEN_SECRET
- Consider making the proxy auto-start or adding to a systemd service

---

## Next up: Phase 2 — Order Intake & Parsing

Per the COA-AUTOMATION-ROADMAP.md:
- Parse the daily ERP email that lists customers needing COAs
- Build an order queue: "Customer X, Order Y needs COAs"
- Customer registry with COA requirements
- This is the trigger for the downstream ERP/WMS integration (Phase 3)

## Domain setup
- App: https://supdox.com (CF Pages)
- Email: {slug}@supdox.com (CF Email Routing → dox-email-worker)
- Legacy: dox.cush.rocks still works (CNAME to Pages)
- DNS: supdox.com on Cloudflare, cush.rocks on name.com
