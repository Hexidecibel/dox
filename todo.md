# Todo

## Upcoming

- Full-text content search — extract text from PDFs on upload, index with Cloudflare Vectorize for semantic search ("find docs about emissions compliance")
- Auto-categorization — AI classifies uploaded docs into document types/tags automatically on upload
- Document summarization — AI-generated summary shown on each document detail page
- Product filter on documents list — requires server-side product filter support (document_products join)
- Cron trigger for expiration alerts — configure Cloudflare Workers Cron to call POST /api/expirations/notify daily
- Bundle size guard — pre-generate large bundles (>50MB) to R2 instead of in-memory ZIP
- Order-to-COA auto-matching (Phase 3) — automatically match order items to existing COA documents by product + lot
